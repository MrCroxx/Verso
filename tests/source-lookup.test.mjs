import assert from "node:assert/strict";
import test from "node:test";
import { layoutFromPdfTextContent, layoutFromTranslationBlocks, trimWordEdge, wordAtPoint, wordContext } from "../lib/source-words.ts";

const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const item = (str, x, baseline, width = 30, height = 12, hasEOL = false) => ({
  str,
  transform: [1, 0, 0, 1, x, baseline],
  width,
  height,
  hasEOL,
});

test("pdf text items become normalized word rectangles", () => {
  const layout = layoutFromPdfTextContent([
    item("Hello", 100, 100, 40, 12),
    item("world", 145, 100, 35, 12, true),
    item("Next", 100, 130, 28, 12),
  ], viewport);
  assert.equal(layout.method, "pdf");
  assert.deepEqual(layout.words.map((word) => word.text), ["Hello", "world", "Next"]);
  assert.deepEqual(layout.words.map((word) => word.line), [0, 0, 1]);
  const hello = layout.words[0].rect;
  assert.ok(Math.abs(hello.x - 100 / 600) < 1e-9);
  assert.ok(Math.abs(hello.y - (800 - 100 - 12) / 800) < 1e-9);
  assert.ok(Math.abs(hello.width - 40 / 600) < 1e-9);
  assert.ok(Math.abs(hello.height - 12 / 800) < 1e-9);
});

test("text matrices with font scaling do not multiply word widths", () => {
  const layout = layoutFromPdfTextContent([
    { str: "Hello", transform: [12, 0, 0, 12, 100, 100], width: 40, height: 12 },
  ], viewport);
  assert.ok(Math.abs(layout.words[0].rect.width - 40 / 600) < 1e-9);
  assert.ok(Math.abs(layout.words[0].rect.height - 12 / 800) < 1e-9);
});

test("text runs split into separately clickable words", () => {
  const layout = layoutFromPdfTextContent([item("Hello there", 100, 100, 66, 12)], viewport);
  assert.deepEqual(layout.words.map((word) => word.text), ["Hello", "there"]);
  assert.ok(Math.abs(layout.words[0].rect.x - 100 / 600) < 1e-9);
  assert.ok(Math.abs(layout.words[1].rect.x - (100 + (6 / 11) * 66) / 600) < 1e-9);
  assert.ok(layout.words[0].rect.width > 0 && layout.words[1].rect.width > 0);
});

test("rotated viewports keep pdf.js baseline geometry", () => {
  const rotated = { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] };
  const layout = layoutFromPdfTextContent([item("Sideways", 100, 100, 40, 12)], rotated);
  const word = layout.words[0];
  assert.equal(word.text, "Sideways");
  assert.ok(word.rect.x >= 0 && word.rect.x < 1);
  assert.ok(word.rect.y >= 0 && word.rect.y < 1);
  assert.ok(word.rect.width > 0);
  assert.ok(word.rect.height > 0);
});

test("hit testing prefers the smallest containing word and tolerates nearby gaps", () => {
  const words = [
    { text: "big", line: 0, rect: { x: .1, y: .1, width: .3, height: .05 } },
    { text: "small", line: 0, rect: { x: .15, y: .1, width: .05, height: .05 } },
    { text: "other", line: 1, rect: { x: .5, y: .3, width: .05, height: .05 } },
  ];
  assert.equal(wordAtPoint(words, .17, .12)?.text, "small");
  assert.equal(wordAtPoint(words, .505, .31)?.text, "other");
  assert.equal(wordAtPoint(words, .42, .12)?.text, undefined);
  assert.equal(wordAtPoint(words, .408, .12)?.text, "big");
  assert.equal(wordAtPoint(words, .405, .12, .002)?.text, undefined);
});

test("highlights shrink to the word core without moving the hit area", () => {
  const word = { text: "Matrimony:", line: 0, rect: { x: .1, y: .2, width: .1, height: .02 } };
  const trimmed = trimWordEdge(word);
  assert.equal(trimmed.text, "Matrimony:");
  assert.ok(Math.abs(trimmed.rect.x - .1) < 1e-9);
  assert.ok(Math.abs(trimmed.rect.width - .09) < 1e-9);
  const quoted = trimWordEdge({ text: '"Hi,"', line: 0, rect: { x: .2, y: .3, width: .05, height: .02 } });
  assert.ok(Math.abs(quoted.rect.x - .21) < 1e-9);
  assert.ok(Math.abs(quoted.rect.width - .02) < 1e-9);
  assert.deepEqual(trimWordEdge({ text: "word", line: 0, rect: { x: .1, y: .1, width: .02, height: .01 } }).rect,
    { x: .1, y: .1, width: .02, height: .01 });
});

test("context joins visible words on the requested lines", () => {
  const words = [
    { text: "line", line: 1, rect: { x: .2, y: .1, width: .05, height: .05 } },
    { text: "first", line: 1, rect: { x: .1, y: .1, width: .05, height: .05 } },
    { text: "next", line: 2, rect: { x: .1, y: .2, width: .05, height: .05 } },
  ];
  assert.equal(wordContext(words, words[0]), "first line");
  assert.equal(wordContext(words, words[0], 1), "first line next");
});

test("translated sentences become clickable words without a text layer", () => {
  const layout = layoutFromTranslationBlocks([{
    kind: "paragraph", text: "", marker: "", trailing: "", align: "left", indent: 0, spaceBefore: "none", size: "sm",
    sentences: [{
      text: "",
      sourceText: "In this case it is shown",
      sourceRects: [
        { x: .1, y: .1, width: .4, height: .02 },
        { x: .1, y: .12, width: .2, height: .02 },
      ],
    }],
  }]);
  assert.equal(layout?.method, "sentence");
  assert.deepEqual(layout.words.map((word) => word.text), ["In", "this", "case", "it", "is", "shown"]);
  assert.deepEqual(layout.words.map((word) => word.line), [0, 0, 0, 0, 1, 1]);
  for (const word of layout.words) {
    assert.ok(word.rect.x >= .1 && word.rect.x + word.rect.width <= .51);
    assert.ok(word.rect.y === .1 || word.rect.y === .12);
  }
  assert.equal(wordAtPoint(layout.words, .17, .11)?.text, "this");
  assert.equal(wordAtPoint(layout.words, .12, .13)?.text, "is");
});

test("sentences without source rectangles do not invent word positions", () => {
  assert.equal(layoutFromTranslationBlocks([{
    kind: "paragraph", text: "", marker: "", trailing: "", align: "left", indent: 0, spaceBefore: "none", size: "sm",
    sentences: [{ text: "", sourceText: "No boxes", sourceRects: [] }],
  }]), null);
});
