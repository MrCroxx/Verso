import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getStorage } from "../db/books.ts";
import type { TranslationTrace, TraceSpan } from "./translation-trace.ts";

const globalState = globalThis as typeof globalThis & { versoTraceState?: {
  context: AsyncLocalStorage<TranslationTrace>; active: Map<string, TranslationTrace>; starts: WeakMap<TranslationTrace, number>;
} };
const state = globalState.versoTraceState ??= { context: new AsyncLocalStorage<TranslationTrace>(), active: new Map(), starts: new WeakMap() };
const starts = state.starts;

async function database() {
  const { db } = getStorage();
  await db.prepare(`CREATE TABLE IF NOT EXISTS translation_traces (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, payload TEXT NOT NULL)`).run();
  return db;
}

export function currentTrace() { const trace = state.context.getStore(); return trace?.status === "running" ? trace : undefined; }
export function traceAttributes(attributes: TranslationTrace["attributes"]) {
  Object.assign(currentTrace()?.attributes ?? {}, attributes);
}
export function startSpan(name: string, attributes: TraceSpan["attributes"] = {}, start = performance.now()) {
  const trace = currentTrace();
  if (!trace) return () => {};
  const span: TraceSpan = { name, startMs: start - starts.get(trace)!, status: "running", attributes };
  trace.spans.push(span);
  return (status: "ok" | "error" = "ok", extra: TraceSpan["attributes"] = {}) => {
    if (span.status !== "running") return;
    span.durationMs = performance.now() - start;
    span.status = status;
    Object.assign(span.attributes, extra);
  };
}
export async function traceStep<T>(name: string, run: () => Promise<T>, attributes: TraceSpan["attributes"] = {}): Promise<T> {
  const end = startSpan(name, attributes);
  try { const value = await run(); end(); return value; }
  catch (error) { end("error"); throw error; }
}
export function bindTrace<T>(run: () => Promise<T>) {
  const trace = currentTrace();
  return () => state.context.run(trace!, run);
}
export async function withTranslationTrace<T>(input: { page: number; bookId?: string }, background: boolean,
  run: () => Promise<T>, onTrace?: (trace: TranslationTrace) => void): Promise<T> {
  const trace: TranslationTrace = { id: randomUUID(), page: input.page, bookId: input.bookId, background,
    startedAt: Date.now(), durationMs: 0, status: "running", attributes: {}, spans: [] };
  starts.set(trace, performance.now());
  state.active.set(trace.id, trace);
  return state.context.run(trace, async () => {
    try { const result = await run(); trace.status = "ok"; return result; }
    catch (error) { trace.status = "error"; throw error; }
    finally {
      trace.durationMs = performance.now() - starts.get(trace)!;
      for (const span of trace.spans) {
        if (span.status === "running") { span.status = trace.status; span.durationMs = trace.durationMs - span.startMs; }
      }
      state.active.delete(trace.id);
      onTrace?.(trace);
      try {
        const db = await database();
        await db.prepare("INSERT OR REPLACE INTO translation_traces VALUES (?1, ?2, ?3)")
          .bind(trace.id, trace.startedAt, JSON.stringify(trace)).run();
        await db.prepare("DELETE FROM translation_traces WHERE id NOT IN (SELECT id FROM translation_traces ORDER BY started_at DESC LIMIT 200)").run();
      } catch { /* Trace storage failure must not fail a successful translation. */ }
    }
  });
}
export async function listTranslationTraces() {
  const db = await database();
  const rows = await db.prepare("SELECT payload FROM translation_traces ORDER BY started_at DESC LIMIT 200").all<{ payload: string }>();
  return [...Array.from(state.active.values(), (trace) => ({ ...trace, durationMs: performance.now() - starts.get(trace)! })),
    ...rows.results.map((row) => JSON.parse(row.payload) as TranslationTrace)].sort((a,b) => b.startedAt - a.startedAt);
}
