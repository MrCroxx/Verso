import { readEventStream } from "./event-stream.ts";

export type TranslationProgress = {
  phase: "queued" | "preparing" | "waiting" | "thinking" | "generating" | "aligning";
  characters?: number;
  tokens?: number;
  tokensEstimated?: boolean;
  tokensPerSecond?: number;
};

// Providers usually report usage only at completion. Never count SSE chunks as tokens.
export function createTranslationStatistics(now = () => performance.now()) {
  let characters = 0, bytes = 0, firstOutputAt: number | undefined, reportedTokens: number | undefined;
  let trailingHighSurrogate = false;
  const encoder = new TextEncoder();
  return {
    receive(delta: string) {
      if (!delta) return;
      firstOutputAt ??= now();
      characters += Array.from(delta).length;
      bytes += encoder.encode(delta).length;
      // JSON deltas can split a surrogate pair even when SSE UTF-8 decoding is correct.
      if (trailingHighSurrogate && /^[\uDC00-\uDFFF]/.test(delta)) { characters--; bytes -= 2; }
      trailingHighSurrogate = /[\uD800-\uDBFF]$/.test(delta);
    },
    reportUsage(usage: unknown) {
      if (!usage || typeof usage !== "object") return false;
      const value = usage as Record<string, unknown>;
      const output = value.output_tokens ?? value.completion_tokens;
      const details = (value.output_tokens_details ?? value.completion_tokens_details) as Record<string, unknown> | undefined;
      const reasoning = details?.reasoning_tokens;
      // A gateway can synthesize content-only totals but retain larger reasoning counts.
      // Such usage cannot calibrate a combined reasoning + text counter.
      if (!Number.isSafeInteger(output) || (output as number) < 0
        || (typeof reasoning === "number" && reasoning > (output as number))) return false;
      reportedTokens = output as number;
      return true;
    },
    snapshot() {
      const elapsed = firstOutputAt === undefined ? 0 : (now() - firstOutputAt) / 1000;
      const tokens = reportedTokens ?? Math.ceil(bytes / 4);
      return { characters, tokens, tokensEstimated: reportedTokens === undefined,
        tokensPerSecond: elapsed >= 1 ? tokens / elapsed : undefined };
    },
  };
}

export async function readTranslationResponse<T>(response: Response, onProgress: (progress: TranslationProgress) => void): Promise<T> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json() as Promise<T>;
  if (!response.body) throw new Error("Translation stream is unavailable.");
  for await (const event of readEventStream(response.body)) {
    const data = JSON.parse(event.data);
    if (event.event === "progress") onProgress(data);
    if (event.event === "result") return data as T;
    if (event.event === "error") return data as T;
  }
  throw new Error("Translation stream ended before the result arrived.");
}
