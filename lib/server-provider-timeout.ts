export const PROVIDER_TIMEOUTS = {
  headersMs: 5 * 60_000,
  idleMs: 5 * 60_000,
  totalMs: 30 * 60_000,
};

export type ProviderTimeoutPhase = "headers" | "idle" | "total";

export class ProviderTimeoutError extends Error {
  readonly phase: ProviderTimeoutPhase;

  constructor(phase: ProviderTimeoutPhase, milliseconds: number) {
    const duration = `${milliseconds / 60_000} minutes`;
    super(phase === "headers"
      ? `The AI provider did not send response headers within ${duration}.`
      : phase === "idle"
        ? `The AI provider sent no response data for ${duration}.`
        : `The AI provider exceeded the total translation limit of ${duration}.`);
    this.name = "ProviderTimeoutError";
    this.phase = phase;
  }
}

// Keep the deadline active until the body has been consumed, including JSON fallbacks.
export async function withProviderResponse<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  consume: (response: Response) => Promise<T>,
  limits = PROVIDER_TIMEOUTS,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ProviderTimeoutError | undefined;
  const expire = (phase: ProviderTimeoutPhase, milliseconds: number) => {
    timeout ??= new ProviderTimeoutError(phase, milliseconds);
    controller.abort(timeout);
  };
  let activityTimer = setTimeout(() => expire("headers", limits.headersMs), limits.headersMs);
  const totalTimer = setTimeout(() => expire("total", limits.totalMs), limits.totalMs);
  const activity = () => {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => expire("idle", limits.idleMs), limits.idleMs);
  };
  let response: Response | undefined;
  try {
    const incoming = await request(controller.signal);
    controller.signal.throwIfAborted();
    activity();
    // Count raw bytes so SSE comments, fragmented events, and reasoning all keep
    // a live connection active without exposing or interpreting their contents.
    response = incoming.body ? new Response(incoming.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        if (chunk.byteLength) activity();
        stream.enqueue(chunk);
      },
    })), { status: incoming.status, statusText: incoming.statusText, headers: incoming.headers }) : incoming;
    const result = await consume(response);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    // Fetch/body readers can replace the abort reason with a generic AbortError.
    throw timeout ?? error;
  } finally {
    clearTimeout(activityTimer);
    clearTimeout(totalTimer);
    controller.abort();
    await response?.body?.cancel().catch(() => undefined);
  }
}
