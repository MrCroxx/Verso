export type TraceSpan = { name: string; startMs: number; durationMs?: number; status: "running" | "ok" | "error"; attributes: Record<string, string | number | boolean> };
export type TranslationTrace = {
  id: string;
  page: number;
  bookId?: string;
  background: boolean;
  startedAt: number;
  durationMs: number;
  status: "running" | "ok" | "error";
  attributes: Record<string, string | number | boolean>;
  spans: TraceSpan[];
};

export function traceServerTiming(trace: TranslationTrace) {
  return [`total;dur=${trace.durationMs.toFixed(1)}`, ...trace.spans
    .filter((span) => span.durationMs !== undefined)
    .map((span, index) => `s${index};dur=${span.durationMs!.toFixed(1)};desc="${span.name}"`)].join(", ");
}

export function chromeTrace(traces: TranslationTrace[]) {
  return { traceEvents: traces.flatMap((trace, index) => [
    { ph: "M", name: "process_name", pid: index + 1, tid: 0, args: { name: `Page ${trace.page} · ${trace.id.slice(0,8)}` } },
    // Each stage gets a lane so concurrently overlapping spans are never treated as a call stack.
    ...trace.spans.flatMap((span, lane) => [
      { ph: "M", name: "thread_name", pid: index + 1, tid: lane + 1, args: { name: `${span.name}${span.attributes.page ? ` · ${span.attributes.page}` : ""}` } },
      { ph: "X", cat: "verso", name: span.name, pid: index + 1, tid: lane + 1,
        ts: (trace.startedAt + span.startMs) * 1000,
        dur: (span.durationMs ?? Math.max(0, trace.durationMs - span.startMs)) * 1000,
        args: { ...span.attributes, status: span.status, traceId: trace.id, ...trace.attributes },
      },
    ]),
  ]) };
}

// Server spans use relative durations; anchor them at response receipt to avoid host clock skew.
export function recordTranslationTrace(trace: TranslationTrace, receivedAt = performance.now()) {
  for (const span of trace.spans) {
    const name = `Verso ${trace.id} ${span.name}`;
    try {
      const start = Math.max(0, receivedAt - trace.durationMs + span.startMs);
      performance.measure(name, { start, duration: span.durationMs ?? 0, detail: { devtools: {
        track: `Page ${trace.page} · ${trace.id.slice(0, 8)}`, trackGroup: "Verso translation",
        color: span.status === "error" ? "error" : span.name.startsWith("provider") ? "primary" : "secondary",
        properties: Object.entries({ ...trace.attributes, ...span.attributes, traceId: trace.id, clock: "Server times anchored at response receipt" }).map(([key, value]) => [key, String(value)]),
      } } });
      performance.clearMeasures(name);
    } catch { /* Diagnostics must not affect reading on browsers without User Timing support. */ }
  }
}

export function recordClientTiming(stage: string, start: number, page: number) {
  const name = `Verso page ${page} ${stage}`;
  try {
    performance.measure(name, { start, detail: { devtools: { track: `Page ${page} browser`, trackGroup: "Verso translation", color: "tertiary" } } });
    performance.clearMeasures(name);
  } catch { /* Timing is optional in older browsers. */ }
}
