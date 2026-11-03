import assert from "node:assert/strict";
import test from "node:test";
import { parseReadingProgress, readReadingProgress, READING_PROGRESS_KEY, writeReadingProgress } from "../lib/reading-progress.ts";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: () => values.get(READING_PROGRESS_KEY),
  };
}

test("reading progress is stored per book and restored", () => {
  const target = storage();
  writeReadingProgress("book-a", 42, target);
  writeReadingProgress("book-b", 7, target);
  assert.equal(readReadingProgress("book-a", target), 42);
  assert.equal(readReadingProgress("book-b", target), 7);
  assert.equal(readReadingProgress("book-c", target), undefined);
  assert.deepEqual(JSON.parse(target.value()), { "book-a": 42, "book-b": 7 });
});

test("reading progress ignores invalid stored entries", () => {
  assert.deepEqual(parseReadingProgress(null), {});
  assert.deepEqual(parseReadingProgress("not-json"), {});
  assert.deepEqual(parseReadingProgress("[]"), {});
  assert.deepEqual(parseReadingProgress(JSON.stringify({ a: 3, b: -1, c: 1.5, d: "4", e: null })), { a: 3 });
});

test("reading progress does not overwrite a book with an invalid page", () => {
  const target = storage({ [READING_PROGRESS_KEY]: JSON.stringify({ book: 12 }) });
  writeReadingProgress("book", 0, target);
  writeReadingProgress("book", 2.5, target);
  writeReadingProgress("", 5, target);
  assert.equal(readReadingProgress("book", target), 12);
});

test("reading progress survives unavailable storage", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readReadingProgress("book", broken), undefined);
  assert.doesNotThrow(() => writeReadingProgress("book", 4, broken));
});
