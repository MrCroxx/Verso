import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { normalizeLayoutBlocks, hasLayoutContent } from "../lib/translation-layout.ts";
import { restoreCompactBlocks } from "../lib/translation-source-plan.ts";
import { recoverSourceCodeBlocks } from "../lib/source-code.ts";
import { parsePdfWordLayout, alignSourceBlocks } from "../lib/source-alignment.ts";
import { makeSourcePdf } from "./fixtures/source-pages.mjs";

const code = 'agent = Agent(\n    name="Weather agent",\n    instructions="Use tools",\n    tools=[get_weather],\n)';
const image = () => normalizeLayoutBlocks([{ kind: "image", sourceRect: { x: .1, y: .12, width: .8, height: .14 } }]);
let poppler = false;
try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); poppler = true; } catch { /* Native tests are optional on unbundled hosts. */ }

test("code survives provider restoration and normalization with exact whitespace and literal HTML", () => {
  const text = `${code}\nprint("<script>alert(1)</script>")\n`;
  const result = restoreCompactBlocks([{ kind: "code", marker: "python", sentences: [{ text, sourceText: text, sourceRects: [] }] }]);
  assert.equal(result[0].kind, "code");
  assert.equal(result[0].text, text);
  assert.equal(result[0].marker, "python");
  assert.ok(hasLayoutContent(result));
  assert.deepEqual(normalizeLayoutBlocks(result), result);
});

test("native PDF code recovers indentation and the closing line beyond a clipped image estimate", { skip: !poppler }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verso-code-"));
  try {
    const file = path.join(dir, "code.pdf");
    await writeFile(file, makeSourcePdf({ code: true }));
    const layout = parsePdfWordLayout(execFileSync("pdftotext", ["-bbox-layout", file, "-"], { encoding: "utf8" }));
    const original = image();
    const result = alignSourceBlocks(original, layout);
    assert.equal(result[0].kind, "code");
    assert.equal(result[0].text, code);
    assert.equal(result[0].marker, "python");
    assert.equal(original[0].kind, "image");
    assert.ok(result[0].sourceRect.y + result[0].sourceRect.height > original[0].sourceRect.y + original[0].sourceRect.height);
    assert.deepEqual(alignSourceBlocks(result, layout), result);
    assert.deepEqual(recoverSourceCodeBlocks(original, { ...layout, method: "ocr" }), original);
    const unlabelled = { ...layout, words: layout.words.filter((w) => w.text !== "Python") };
    assert.deepEqual(recoverSourceCodeBlocks(original, unlabelled), original);
    const diagram = { ...layout, words: layout.words.map((w, i) => ({ ...w, rect: { ...w.rect, width: w.rect.width * (i % 2 ? .6 : 1.4) } })) };
    assert.deepEqual(recoverSourceCodeBlocks(original, diagram), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("model code typography is grounded locally without rewriting code or source mappings", () => {
  const text = "print(value)";
  const blocks = normalizeLayoutBlocks([{ kind: "code", text, fontSize: .2, sourceRect: { x: .1, y: .2, width: .5, height: .1 },
    sentences: [{ text, sourceText: text, sourceRects: [{ x: .1, y: .2, width: .2, height: .02 }] }] }]);
  const layout = { width: 600, height: 800, method: "pdf", words: [
    { text, line: 1, fontSize: .018, rect: { x: .1, y: .2, width: .2, height: .02 } }] };
  const result = alignSourceBlocks(blocks, layout);
  assert.equal(result[0].fontSize, .018);
  assert.equal(result[0].text, text);
  assert.deepEqual(result[0].sentences, blocks[0].sentences);
});

test("copy uses the exact code and falls back on LAN HTTP, restoring focus and selection", async () => {
  const { copyText } = await import("../lib/clipboard.ts");
  const original = Object.fromEntries(["navigator", "window", "document", "HTMLElement"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const text = '\tname = "<literal>"\n    pass\n';
  let copied, removed = false, focused = false, restored = false;
  const range = {};
  class Element { focus() { focused = true; } }
  const field = { value: "", style: {}, focus() {}, select() {}, remove() { removed = true; } };
  const selection = { rangeCount: 1, getRangeAt: () => ({ cloneRange: () => range }), removeAllRanges() {}, addRange: (value) => { restored = value === range; } };
  const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    set("navigator", { clipboard: { writeText: async (value) => { copied = value; } } });
    await copyText(text);
    assert.equal(copied, text);
    set("HTMLElement", Element);
    set("window", { getSelection: () => selection });
    set("document", { activeElement: new Element(), createElement: () => field, body: { appendChild() {} },
      execCommand: () => { copied = field.value; return true; } });
    for (const clipboard of [undefined, { writeText: async () => { throw new Error("Permission denied"); } }]) {
      set("navigator", { clipboard });
      await copyText(text);
      assert.equal(copied, text);
      assert.ok(removed && focused && restored);
    }
    globalThis.document.execCommand = () => false;
    await assert.rejects(copyText(text), /rejected/);
    assert.ok(removed && focused && restored);
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
