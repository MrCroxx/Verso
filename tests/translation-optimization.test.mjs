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
import { addTranslationUsage, normalizeTranslationUsage, providerTranslationUsage, translationCacheHitRate, translationTokensPerSecond, translationUsageCost } from "../lib/translation-usage.ts";
import { calculateTranslationCost, deepseekPricingPeriod, formatTranslationCost, normalizeTranslationPricing } from "../lib/translation-pricing.ts";
import { normalizeAiProviderSettingsUpdate } from "../lib/ai-provider-settings.ts";

test("keeps provider totals without double-counting reasoning or cached input and rejects unknown usage", () => {
  const usage = providerTranslationUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 20 } });
  assert.deepEqual(usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 80 });
  assert.deepEqual(providerTranslationUsage({ input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 80 } }), usage);
  assert.deepEqual(providerTranslationUsage({ prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 80 }), usage);
  assert.deepEqual(providerTranslationUsage({ total_tokens: 150 }), { totalTokens: 150, inputTokens: undefined, outputTokens: undefined });
  assert.equal(providerTranslationUsage({ input_tokens: 120 }), undefined);
  for (const value of [undefined, null, {}, { total_tokens: -1 }, { total_tokens: "150" }, { total_tokens: Infinity }]) {
    assert.equal(providerTranslationUsage(value), undefined);
  }
  assert.equal(providerTranslationUsage({ input_tokens: 0, output_tokens: 0 }).totalTokens, 0);
  assert.deepEqual(addTranslationUsage(usage, usage), { inputTokens: 240, outputTokens: 60, totalTokens: 300, cachedInputTokens: 160 });
  assert.equal(addTranslationUsage(usage, undefined), undefined);
  assert.equal(addTranslationUsage(undefined, usage), undefined);
});

test("calculates cached input pricing and combines attempt costs and TPS without averaging rates", () => {
  const pricing = { currency: "USD", inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 };
  const first = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 800, outputSeconds: 2 };
  const second = { inputTokens: 2000, outputTokens: 300, totalTokens: 2300, cachedInputTokens: 1000, outputSeconds: 3 };
  assert.deepEqual(calculateTranslationCost(first, pricing), { currency: "USD", amount: 0.0016 });
  assert.equal(translationCacheHitRate(first), 0.8);
  assert.equal(translationTokensPerSecond(first), 50);
  const combined = addTranslationUsage({ ...first, cost: calculateTranslationCost(first, pricing) },
    { ...second, cost: calculateTranslationCost(second, pricing) });
  assert.equal(translationTokensPerSecond(combined), 80);
  assert.equal(translationCacheHitRate(combined), 0.6);
  assert.ok(Math.abs(combined.cost.amount - 0.0065) < 1e-12);
  assert.deepEqual(normalizeTranslationUsage(JSON.parse(JSON.stringify(combined))), combined);
  assert.equal(calculateTranslationCost({ ...first, cachedInputTokens: undefined }, pricing), undefined);
  assert.deepEqual(calculateTranslationCost(first, { ...pricing, cachedInputPerMillion: undefined }), { currency: "USD", amount: 0.0028 });
  assert.equal(calculateTranslationCost(first, { currency: "USD", inputPerMillion: 2 }), undefined);
  assert.equal(calculateTranslationCost({ totalTokens: 1100 }, pricing), undefined);
  assert.deepEqual(calculateTranslationCost(first, { currency: "CNY", inputPerMillion: 0, outputPerMillion: 0 }), { currency: "CNY", amount: 0 });
  const unknown = normalizeTranslationUsage({ ...first, cachedInputTokens: 1001, outputSeconds: 0, cost: { currency: "USD", amount: -1 } });
  assert.equal(translationCacheHitRate(unknown), undefined);
  assert.equal(translationTokensPerSecond(unknown), undefined);
  assert.equal(unknown.cost, undefined);
  assert.equal(translationCacheHitRate({ inputTokens: 0, cachedInputTokens: 0 }), 0);
  assert.equal(addTranslationUsage(first, { ...second, outputSeconds: undefined }).outputSeconds, undefined);
});

test("estimates unpriced history from saved tokens while preserving recorded costs", () => {
  const usage = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 800 };
  const pricing = { currency: "USD", inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 };
  assert.equal(translationUsageCost(usage), undefined);
  assert.deepEqual(translationUsageCost(usage, pricing), { currency: "USD", amount: 0.0016 });
  assert.deepEqual(translationUsageCost(usage, { ...pricing, outputPerMillion: 10 }), { currency: "USD", amount: 0.0018 });
  const savedCost = { currency: "EUR", amount: 0 };
  assert.deepEqual(translationUsageCost({ ...usage, cost: savedCost }, pricing), savedCost);
  assert.equal(usage.cost, undefined, "Display estimates must not modify stored usage");
  assert.equal(translationUsageCost({ totalTokens: 1100 }, pricing), undefined);
  assert.equal(translationUsageCost(usage, { currency: "USD", inputPerMillion: 2 }), undefined);
  assert.equal(translationUsageCost({ ...usage, cachedInputTokens: undefined }, pricing), undefined);
  const scheduled = { ...pricing, schedule: "deepseek-peak" };
  assert.deepEqual(translationUsageCost(usage, scheduled, Date.parse("2026-09-14T09:00:00+08:00")),
    { currency: "USD", amount: 0.0032, period: "peak" });
  assert.deepEqual(translationUsageCost(usage, scheduled, Date.parse("2026-09-14T12:00:00+08:00")),
    { currency: "USD", amount: 0.0016, period: "offPeak" });
  assert.equal(translationUsageCost(usage, scheduled), undefined, "Unknown dates must not use today's peak period");
});

test("validates optional prices, preserves same-model pricing and clears it on model changes", () => {
  const pricing = { currency: "CNY", inputPerMillion: 1.5, outputPerMillion: 6, cachedInputPerMillion: 0 };
  const update = { provider: "compatible", endpoint: "http://localhost/v1", model: "test", reasoningEffort: "none", pricing };
  const existing = normalizeAiProviderSettingsUpdate(update, null);
  assert.deepEqual(existing.pricing, pricing);
  assert.deepEqual(normalizeAiProviderSettingsUpdate({ ...update, pricing: undefined }, existing).pricing, pricing);
  assert.equal(normalizeAiProviderSettingsUpdate({ ...update, model: "new", pricing: undefined }, existing).pricing, undefined);
  assert.equal(normalizeAiProviderSettingsUpdate({ ...update, pricing: null }, existing).pricing, undefined);
  for (const invalid of [{ ...pricing, inputPerMillion: -1 }, { ...pricing, outputPerMillion: Infinity },
    { ...pricing, cachedInputPerMillion: "0" }, { ...pricing, currency: "invalid" }]) {
    assert.equal(normalizeTranslationPricing(invalid), undefined);
    assert.equal(normalizeAiProviderSettingsUpdate({ ...update, pricing: invalid }, existing), null);
  }
});

test("applies DeepSeek weekday peak windows with exact boundaries independently of local timezone", () => {
  for (const [time, expected] of [
    ['2026-09-14T08:59:59.999+08:00', 'offPeak'], ['2026-09-14T09:00:00+08:00', 'peak'],
    ['2026-09-14T11:59:59.999+08:00', 'peak'], ['2026-09-14T12:00:00+08:00', 'offPeak'],
    ['2026-09-14T13:59:59.999+08:00', 'offPeak'], ['2026-09-14T14:00:00+08:00', 'peak'],
    ['2026-09-14T17:59:59.999+08:00', 'peak'], ['2026-09-14T18:00:00+08:00', 'offPeak'],
    ['2026-09-18T10:00:00+08:00', 'peak'], ['2026-09-19T10:00:00+08:00', 'offPeak'],
    ['2026-09-20T15:00:00+08:00', 'offPeak'], ['2026-09-14T00:00:00+08:00', 'offPeak'],
  ]) assert.equal(deepseekPricingPeriod(Date.parse(time)), expected, time);
  const pricing = { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 4, cachedInputPerMillion: 0.02, schedule: 'deepseek-peak' };
  assert.deepEqual(normalizeTranslationPricing(pricing), pricing);
  assert.equal(normalizeTranslationPricing({ ...pricing, schedule: 'unknown' }), undefined);
  const usage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, totalTokens: 1100 };
  const peak = calculateTranslationCost(usage, pricing, Date.parse('2026-09-14T09:00:00+08:00'));
  const offPeak = calculateTranslationCost(usage, pricing, Date.parse('2026-09-14T12:00:00+08:00'));
  assert.deepEqual(offPeak, { amount: 0.000616, currency: 'CNY', period: 'offPeak' });
  assert.deepEqual(peak, { amount: offPeak.amount * 2, currency: 'CNY', period: 'peak' });
  assert.equal(addTranslationUsage({ ...usage, cost: peak }, { ...usage, cost: offPeak }).cost.period, 'mixed');
  assert.equal(addTranslationUsage({ ...usage, cost: peak }, { ...usage, cost: peak }).cost.period, 'peak');
  assert.deepEqual(normalizeTranslationUsage({ ...usage, cost: peak }).cost, peak);
});

test("supports international currencies and formats estimated cost using the interface locale", () => {
  for (const currency of ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'INR', 'KWD']) {
    assert.equal(normalizeTranslationPricing({ currency }).currency, currency);
    const cost = { currency, amount: 1234.56 };
    assert.equal(normalizeTranslationUsage({ totalTokens: 10, cost }).cost.currency, currency);
    for (const locale of ['zh-CN', 'en-US', 'de-DE', 'ja-JP']) {
      assert.equal(formatTranslationCost(cost, locale), new Intl.NumberFormat(locale,
        { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 6 }).format(cost.amount));
    }
  }
  assert.match(formatTranslationCost({ currency: 'CNY', amount: 0.0000001 }, 'zh-CN'), /^<.*0.000001/);
});

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
