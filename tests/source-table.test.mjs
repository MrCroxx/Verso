import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLayoutBlocks } from "../lib/translation-layout.ts";
import { restoreCompactBlocks } from "../lib/translation-source-plan.ts";
import { alignSourceBlocks } from "../lib/source-alignment.ts";
import { groupTranslationMedia } from "../lib/translation-media.ts";

function fixture() {
  const words = [], blocks = [];
  const rows = [["Type", "Description", "Examples"], ["Data", "Retrieve context", "Query databases"], ["Action", "Update records", "Send messages"]];
  rows.forEach((cells, row) => {
    const y = .2 + row * .12;
    cells.forEach((cell, column) => {
      let x = [.1, .3, .65][column];
      for (const text of cell.split(" ")) {
        words.push({ text, line: row * 3 + column, rect: { x, y, width: text.length * .008, height: .02 }, fontSize: .02 });
        x += text.length * .008 + .008;
      }
    });
    blocks.push({ kind: "paragraph", sourceRect: { x: .1, y: y - .005, width: .8, height: .06 },
      text: cells.map((_, i) => `译文${row}-${i}`).join(""), sentences: cells.map((sourceText, i) => ({ sourceText, text: `译文${row}-${i}`, sourceRects: [] })) });
  });
  return { blocks: normalizeLayoutBlocks(blocks), layout: { width: 600, height: 800, method: "pdf", words } };
}

test("cached cells become a real header and rows only when all source columns match", () => {
  const { blocks, layout } = fixture();
  const result = alignSourceBlocks(blocks, layout);
  assert.deepEqual(result.map((b) => b.kind), ["table_header", "table_row", "table_row"]);
  assert.deepEqual(result.map((b) => b.text), blocks.map((b) => b.text));
  assert.equal(blocks[0].kind, "paragraph");
  assert.ok(result.every((row) => row.sentences.every((cell) => cell.sourceRects.length)));
  assert.equal(result[2].sentences[0].sourceRects[0].x, .1);
  const grouped = groupTranslationMedia(result);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].tableRows.length, 3);
  assert.deepEqual(alignSourceBlocks(result, layout), result);
});

test("ambiguous or incomplete legacy cells and ordinary prose are not guessed into columns", () => {
  const { blocks, layout } = fixture();
  const changed = structuredClone(blocks);
  changed[2].sentences[1].sourceText = "Unrelated text";
  assert.ok(alignSourceBlocks(changed, layout).every((b) => b.kind === "paragraph"));
  assert.ok(alignSourceBlocks(blocks, { ...layout, method: "ocr" }).every((b) => b.kind === "paragraph"));
  assert.ok(alignSourceBlocks(blocks.slice(0, 2), layout).every((b) => b.kind === "paragraph"));
});

test("provider tables preserve empty cells, complete cell text and separate neighboring tables", () => {
  const row = (kind, values) => ({ kind, sentences: values.map((text) => ({ text, sourceText: text, sourceRects: [] })) });
  const result = restoreCompactBlocks([row("table_header", ["Type", "Description", "Examples"]),
    row("table_row", ["A", "", "<script>literal</script>"]), row("table_row", ["", "", ""]),
    row("table_header", ["Next", "Table"]), row("table_row", ["B", "C"])]);
  assert.equal(result[1].sentences.length, 3);
  assert.equal(result[1].sentences[1].text, "");
  assert.equal(result[2].sentences.length, 3);
  assert.deepEqual(normalizeLayoutBlocks(result), result);
  const grouped = groupTranslationMedia(result);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((g) => g.tableRows.length), [3, 2]);
});

test("table component renders semantic headers, separate cells, empty cells and escaped content", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { loadTableComponent } = await import("./fixtures/table-component.mjs");
  const Component = await loadTableComponent();
  const { blocks, layout } = fixture();
  const rows = alignSourceBlocks(blocks, layout);
  rows[1].sentences[1].text = "";
  rows[1].sentences[2].text = "<script>literal</script>";
  const html = renderToStaticMarkup(createElement(Component, { rows, contents: rows.flatMap((row) => row.sentences.map((cell) => cell.text)) }));
  assert.equal((html.match(/<th scope="col">/g) ?? []).length, 3);
  assert.equal((html.match(/<td>/g) ?? []).length, 6);
  assert.match(html, /<td><\/td>/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /min-width:27rem/);
});

test("explicit tables align without accurate model rectangles or multiple data rows", () => {
  const { blocks, layout } = fixture();
  const rows = blocks.slice(0, 2).map((row, i) => ({ ...row, kind: i ? "table_row" : "table_header", sourceRect: { ...row.sourceRect, y: .02 + i * .04 } }));
  const aligned = alignSourceBlocks(rows, layout);
  assert.ok(aligned.every((row) => row.sentences.every((cell) => cell.sourceRects.length)));
  assert.equal(aligned[1].sentences[0].sourceRects[0].y, .32);
  assert.deepEqual(aligned.map((r) => r.text), rows.map((r) => r.text));
  const headerless = alignSourceBlocks([{ ...blocks[1], kind: "table_row" }], layout);
  assert.ok(headerless[0].sentences.every((cell) => cell.sourceRects.length));
  const ocr = alignSourceBlocks(rows, { ...layout, method: "ocr" });
  assert.ok(ocr.every((row) => row.sentences.every((cell) => cell.sourceRects.length)));
});

test("table anchors ignore partial words and missing cells cannot retain guessed highlights", () => {
  const { blocks, layout } = fixture();
  const rows = blocks.map((row, i) => ({ ...row, kind: i ? "table_row" : "table_header" }));
  layout.words.unshift({ text: "Types", line: -1, rect: { x: .1, y: .05, width: .05, height: .02 } });
  rows[1].sentences[2] = { text: "未知", sourceText: "Not present in source", sourceRects: [{ x: .01, y: .01, width: .9, height: .9 }] };
  const aligned = alignSourceBlocks(rows, layout);
  assert.equal(aligned[0].sentences[0].sourceRects[0].y, .2);
  assert.deepEqual(aligned[1].sentences[2].sourceRects, []);
  assert.ok(aligned[1].sentences[0].sourceRects.length);
});

test("table cells are keyboard targets without adding nested interactive text", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { loadTableComponent } = await import("./fixtures/table-component.mjs");
  const Component = await loadTableComponent();
  const { blocks, layout } = fixture();
  const rows = alignSourceBlocks(blocks, layout);
  const props = { rows, contents: rows.flatMap((row) => row.sentences.map((cell) => cell.text)), onHighlight: () => {} };
  const html = renderToStaticMarkup(createElement(Component, props));
  assert.equal((html.match(/class="mapped-table-cell"/g) ?? []).length, 9);
  assert.match(html, /title="Type"/);
  const pending = renderToStaticMarkup(createElement(Component, { ...props, activeCells: Array(9).fill(false) }));
  assert.doesNotMatch(pending, /mapped-table-cell/);
});

test("repeated table values use their row context rather than a neighboring row", () => {
  const { blocks, layout } = fixture();
  const rows = blocks.map((row, i) => ({ ...row, kind: i ? "table_row" : "table_header" }));
  rows[2].sentences[0].sourceText = "Data";
  layout.words.find((word) => word.text === "Action").text = "Data";
  const aligned = alignSourceBlocks(rows, layout);
  assert.equal(aligned[1].sentences[0].sourceRects[0].y, .32);
  assert.equal(aligned[2].sentences[0].sourceRects[0].y, .44);
});
