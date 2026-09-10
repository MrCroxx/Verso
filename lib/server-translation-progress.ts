import type { TranslationProgress } from "./translation-progress.ts";

type Listener = (progress: TranslationProgress) => void;
type Channel = { latest: TranslationProgress; listeners: Set<Listener>; references: number };
const globalState = globalThis as typeof globalThis & { versoProgressChannels?: Map<string, Channel> };
const channels = globalState.versoProgressChannels ??= new Map();

// A late reader sees the latest snapshot from the existing background request.
export function joinTranslationProgress(key: string, listener?: Listener, signal?: AbortSignal, replay = true) {
  let channel = channels.get(key);
  if (!channel) { channel = { latest: { phase: "queued" }, listeners: new Set(), references: 0 }; channels.set(key, channel); }
  const entry = channel;
  entry.references++;
  const removeListener = () => { if (listener) entry.listeners.delete(listener); };
  if (listener && !signal?.aborted) {
    entry.listeners.add(listener);
    if (replay) listener(entry.latest);
    signal?.addEventListener("abort", removeListener, { once: true });
  }
  return {
    publish(progress: TranslationProgress) {
      entry.latest = progress;
      for (const notify of entry.listeners) { try { notify(progress); } catch { /* A disconnected observer must not fail translation. */ } }
    },
    release() {
      removeListener(); signal?.removeEventListener("abort", removeListener);
      if (--entry.references === 0) channels.delete(key);
    },
  };
}
